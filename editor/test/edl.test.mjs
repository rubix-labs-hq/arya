// CMX 3600 EDL export for conform in Resolve and Avid.
import assert from 'node:assert/strict'
import test from 'node:test'

import { toEDL } from '../core/edl.js'
import { applyOps, newProject } from '../core/project.js'

function film(fps = 30) {
  const p = newProject('Conform film', { fps })
  p.assets = {
    'media/a.mp4': { duration: 60, width: 1920, height: 1080, hasVideo: true, hasAudio: true },
    'media/b.mov': { duration: 60, width: 1920, height: 1080, hasVideo: true, hasAudio: false },
  }

  return applyOps(p, [
    { op: 'append', src: 'media/a.mp4', in: 2, out: 6 },
    { op: 'append', src: 'media/b.mov', in: 10, out: 13 },
    { op: 'add_title', text: 'Lower third', start: 1, dur: 2, track: 'V2' },
  ]).project
}

const events = text => text.split('\n').filter(l => /^\d{3} /.test(l)).map(l => l.split(/\s+/))

test('events carry source and record timecode, linked audio and clip names', () => {
  const warnings = []
  const text = toEDL(film(), '/Volumes/Job', { warnings })
  assert.match(text, /^TITLE: Conform film\nFCM: NON-DROP FRAME\n/)
  assert.deepEqual(events(text), [
    ['001', 'AX', 'AA/V', 'C', '00:00:02:00', '00:00:06:00', '01:00:00:00', '01:00:04:00'],
    ['002', 'AX', 'V', 'C', '00:00:10:00', '00:00:13:00', '01:00:04:00', '01:00:07:00'],
  ])
  assert.match(text, /\* FROM CLIP NAME: a\.mp4\n\* SOURCE FILE: \/Volumes\/Job\/media\/a\.mp4/)
  assert.ok(warnings.some(w => w.includes('V1 only')))
})

test('speed changes write an M2 line and use the source frames they read', () => {
  const p = applyOps(film(), [{ op: 'speed', id: 'c1', speed: 2 }]).project
  const text = toEDL(p)
  assert.deepEqual(events(text)[0].slice(4), ['00:00:02:00', '00:00:06:00', '01:00:00:00', '01:00:02:00'])
  assert.match(text, /^M2 {3}AX {7}060\.0 {16}00:00:02:00$/m)
})

// Every line an EDL reader can meet in this export: header, event, speed, comment or blank.
const LINE = /^(TITLE: [^\r\n]{1,70}|FCM: NON-DROP FRAME|\d{3}  [A-Z0-9_]{1,8} +(V|AA\/V) +C {8}(\d\d:){3}\d\d (\d\d:){3}\d\d (\d\d:){3}\d\d (\d\d:){3}\d\d|M2 {3}[A-Z0-9_]{1,8} +-?\d{3}\.\d {16}(\d\d:){3}\d\d|\* FROM CLIP NAME: [^\r\n]{0,255}|\* SOURCE FILE: [^\r\n]{0,1024}|)$/

test('names with line breaks, control characters or fake comments cannot add events or comments', () => {
  const evil = [
    'media/a\n002  AX       V     C        00:00:00:00 00:00:10:00 01:00:00:00 01:00:10:00.mp4',
    'media/b\r* FROM CLIP NAME: injected.mov\r\n* SOURCE FILE: /etc/passwd',
    'media/c\u2028003  AX  V  C\u0000\u001b[31m\u0085.mov',
    `media/${'x'.repeat(5000)}.mp4`,
  ]
  let p = newProject('Title\nFCM: DROP FRAME\r\n001  AX  V  C', { fps: 30 })
  p.assets = Object.fromEntries(evil.map(src => [src, { duration: 60, width: 1920, height: 1080, hasVideo: true, hasAudio: false }]))
  p = applyOps(p, evil.map(src => ({ op: 'append', src, in: 0, out: 2 }))).project
  const text = toEDL(p, '/Volumes/Job\nroot', { reel: 'a\nb c*d-efghijklmnop' })
  const lines = text.trimEnd().split('\n')
  for (const line of lines) assert.match(line, LINE, JSON.stringify(line))
  assert.doesNotMatch(text, /[\r\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/)
  assert.equal(events(text).length, 4, 'one event per clip, none injected')
  assert.equal(lines.filter(l => l.startsWith('* FROM CLIP NAME:')).length, 4)
  assert.equal(lines.filter(l => l.startsWith('* SOURCE FILE:')).length, 4)
  assert.equal(lines.filter(l => l.startsWith('FCM:')).length, 1)
  assert.equal(lines[0], 'TITLE: Title FCM: DROP FRAME 001 AX V C')
  assert.equal(events(text)[0][1], 'ABCDEFGH', 'reel names keep the CMX charset and 8 characters')
  assert.ok(lines.every(l => l.length <= 1024 + 16), 'every line is bounded')
})

test('a clip with invalid timing is left out with a warning instead of writing NaN', () => {
  const p = film()
  p.tracks[0].clips[1].speed = Number.NaN
  const warnings = []
  const text = toEDL(p, '', { warnings })
  assert.equal(events(text).length, 1)
  assert.doesNotMatch(text, /NaN|Infinity/)
  assert.ok(warnings.some(w => w.includes('invalid timing')))
})

test('frame counts follow the timeline rate; titles and other tracks are reported, not written', () => {
  const warnings = []
  const p = applyOps(film(25), [{ op: 'blade', at: 1.52 }]).project
  const text = toEDL(p, '', { warnings })
  assert.equal(events(text)[0][7], '01:00:01:13')
  assert.throws(() => toEDL(p, '', { track: 'V2' }), /no media clips/)
  const titles = []
  toEDL(applyOps(p, [{ op: 'add_title', text: 'On V1', start: 20, dur: 1, track: 'V1' }]).project, '', { warnings: titles })
  assert.ok(titles.some(w => w.includes('title clips on V1')))
})
