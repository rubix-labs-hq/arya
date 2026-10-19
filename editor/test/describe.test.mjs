import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOps, newProject, outline } from '../core/project.js'
import { clipName, describeAt, describeClipDetail, describeFocus, describeRequest } from '../core/describe.js'

// A synthetic interview edit: one graded, keyframed video clip with linked sound, a styled
// title, a marker, a caption and a composition with a shape layer.
function fixture() {
  const p = newProject('Describe fixture', { width: 1080, height: 1920, fps: 30 })
  p.assets['media/interview.mp4'] = { duration: 60, width: 1080, height: 1920, fps: 30, codec: 'h264', hasVideo: true, hasAudio: true }
  return applyOps(p, [
    { op: 'append', src: 'media/interview.mp4', track: 'V1', dur: 20 },
    { op: 'append', src: 'media/interview.mp4', track: 'V1', in: 30, dur: 10 },
    { op: 'update', id: 'c1', set: { grade: { exposure: 0.3, saturation: 1.2, lift: [0, 0, 0.02], look: 'warm' }, opacity: 0.8, volume: -3 } },
    { op: 'effect', id: 'c1', type: 'vignette', params: { amount: 0.4 } },
    { op: 'keyframe', id: 'c1', prop: 'scale', at: 0, value: 1 },
    { op: 'keyframe', id: 'c1', prop: 'scale', at: 5, value: 1.2, ease: 'smooth' },
    { op: 'transition', id: 'c2', type: 'crossDissolve', dur: 1 },
    { op: 'add_title', text: 'Meet Dana', track: 'V3', start: 1, dur: 4, title: { size: 96, anim: 'rise' } },
    { op: 'marker', t: 12, label: 'Best quote' },
    { op: 'add_comp', name: 'Lower third', width: 1080, height: 300, duration: 4 },
    { op: 'add_shape', comp: 'k1', track: 'V1', dur: 4, shape: { type: 'rect', width: 600, height: 120, fill: { color: '#101820' } } },
    { op: 'comp_clip', target: 'k1', track: 'V2', start: 2, dur: 4 },
  ]).project
}

test('the focus names grade values, effect parameters, keyframe times and title styling for a selection', () => {
  const p = fixture()
  const text = describeFocus(p, { selection: ['c1', 'c3'], playhead: 3 })
  assert.match(text, /^Open: Main timeline, 1080x1920 at 30 fps/)
  assert.match(text, /Playhead: 00:00:03:00 \(3 s\)\./)
  assert.match(text, /Selection: 2 clips\./)
  assert.match(text, /c1 video "interview\.mp4" on V1 Video 1, 00:00:00:00 to 00:00:20:00 \(20 s\)/)
  assert.match(text, /Grade: exposure \+0\.3, saturation 1\.2, lift \[0, 0, 0\.02\], look warm/)
  assert.match(text, /Effects: \[0\] vignette \(amount 0\.4/)
  assert.match(text, /Keyframes: scale: 00:00:00:00 100% → 00:00:05:00 120% \(smooth\)/)
  assert.match(text, /Transform: opacity 80%/)
  assert.match(text, /Audio: volume -3 dB/)
  assert.match(text, /Media: 1080x1920, 30 fps, 60 s long, h264, has audio/)
  assert.match(text, /Linked with: c1a \(audio on A1\)/)
  assert.match(text, /Title: "Meet Dana"; .*96 px.*animation rise/)
})

test('the focus lists the layers under the playhead top first with source timecode', () => {
  const p = fixture()
  const text = describeFocus(p, { playhead: 3 })
  const under = text.slice(text.indexOf('Under the playhead'), text.indexOf('Selection:'))
  const order = ['V3 Titles', 'V2 Video 2', 'V1 Video 1', 'A1 Audio 1'].map(name => under.indexOf(`- ${name}`))
  assert.ok(order.every(index => index > 0), under)
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.match(under, /c1 video "interview\.mp4", 3 s into the clip, source frame 00:00:03:00/)
  assert.match(text, /Selection: nothing selected/)
  assert.match(describeFocus(p, { playhead: 120 }), /Under the playhead: nothing/)
  assert.match(describeFocus(p, { playhead: 12 }), /Markers within 2 s: m1 "Best quote" at 00:00:12:00/)
})

test('compositions, their layers and where they are placed appear even though outline() omits them', () => {
  const p = fixture()
  assert.doesNotMatch(outline(p), /Lower third/)
  const text = describeFocus(p, {})
  assert.match(text, /Compositions:\n- k1 "Lower third": 1080x300, 4 s, 4 tracks, 1 layer \(c4 shape "Rect"\); placed as c5/)
  const inside = describeFocus(p, { comp: 'k1', playhead: 1 })
  assert.match(inside, /^Open: Composition "Lower third" \(k1\), 1080x300/)
  assert.match(inside, /c4 shape "Rect", 1 s into the clip/)
})

test('transition selections and a source range after a cut are explained', () => {
  const p = fixture()
  const text = describeFocus(p, { selection: ['tr:c2', 'c2'] })
  assert.match(text, /Transition into c2: crossDissolve, 1 s/)
  assert.match(text, /Source: media\/interview\.mp4 from 00:00:30:00 to 00:00:40:00/)
  assert.match(text, /Transition in: crossDissolve, 1 s centered on 00:00:20:00/)
})

test('describe requests validate the composition and describe times and missing clips', () => {
  const p = fixture()
  assert.throws(() => describeRequest(p, { comp: 'k9' }), /no composition k9/)
  const text = describeRequest(p, { ids: ['c1', 'missing'], at: 1.5 })
  assert.match(text, /^At 00:00:01:15 \(1\.5 s\) in Main timeline:/)
  assert.match(text, /missing: not found in this project/)
  assert.equal(describeAt(p, 999).length, 0)
  assert.equal(describeClipDetail(p, 'c1')[0].startsWith('c1 video'), true)
  assert.equal(clipName(p, p.tracks[2].clips[0]), 'Meet Dana')
  assert.equal(describeRequest(null, {}), 'No project is open.')
})

test('large selections stay within the focus budget and say how to read the rest', () => {
  let p = fixture()
  p = applyOps(p, Array.from({ length: 60 }, (_, i) => ({ op: 'add_title', text: `Line ${i} ${'x'.repeat(80)}`, track: 'V3', start: 10 + i, dur: 1, title: { font: 'Avenir Next', size: 80 } }))).project
  const ids = p.tracks.flatMap(track => track.clips.map(clip => clip.id))
  const text = describeFocus(p, { selection: ids, limit: 4000 })
  assert.ok(text.length <= 4000, String(text.length))
  assert.match(text, /Shortened\. Use GET \/api\/describe/)
  assert.match(describeFocus(p, { selection: ids }), /more selected clips\. Use GET \/api\/describe/)
})

test('track faders, effect chains, caption styling and the master bus are described', () => {
  let p = fixture()
  p = applyOps(p, [
    { op: 'update_track', id: 'A1', set: { volume: -4, pan: -0.25, solo: true, fx: [{ type: 'compressor', enabled: true, params: { threshold: -20, ratio: 3 } }, { type: 'eq', enabled: false, params: { bands: [{ type: 'highpass', freq: 80, gain: 0, q: 0.71 }] } }] } },
    { op: 'captions', items: [{ t: 0, end: 2, text: 'Hello there' }] },
    { op: 'project', set: { master: { volume: -1.5, limiter: { enabled: true, ceiling: -1, release: 80 }, target: -14, fx: [{ type: 'gain', enabled: true, params: { gain: 2 } }] } } },
    { op: 'update', id: 'c1', set: { fx: [{ type: 'deesser', enabled: true, params: { threshold: -28 } }] } },
  ]).project
  const caption = p.tracks.find(track => track.kind === 'caption')
  p = applyOps(p, [{ op: 'update_track', id: caption.id, set: { burnIn: true, style: { font: 'Inter', size: 48, color: '#ffffff', y: 0.85 } } }]).project
  const text = describeFocus(p, { selection: ['c1'] })
  assert.match(text, /Tracks and mix \(settings that differ from the defaults\):/)
  assert.match(text, /- A1 Audio 1 \(audio\): solo, volume -4 dB, pan -0\.25, effects \[0\] compressor \(threshold -20, ratio 3\); \[1\] EQ off \(highpass 80 Hz\)/)
  assert.match(text, new RegExp(`- ${caption.id} Captions \\(caption\\): burned in, style Inter, 48 px, #ffffff, plate #000000aa, at 85% height`))
  assert.match(text, /- Master: volume -1\.5 dB, effects \[0\] gain \(gain 2\), limiter ceiling -1 dBTP, release 80 ms, loudness target -14 LUFS/)
  assert.match(text, /Audio: volume -3 dB, effects \[0\] deesser \(threshold -28\)/)
  assert.doesNotMatch(describeFocus(fixture(), {}), /Tracks and mix/, 'default faders add nothing')
})

test('inherited object names such as constructor are not compositions', async () => {
  const p = fixture()
  for (const comp of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.throws(() => describeRequest(p, { comp }), new RegExp(`no composition ${comp}`))
    assert.match(describeFocus(p, { comp, playhead: 3 }), /^Open: Main timeline/)
  }
  const { describeStep } = await import('../core/assistant-steps.js')
  assert.throws(() => describeStep(p, { path: '/api/video/denoise', body: { clip: 'c1', comp: 'constructor' } }), /no composition constructor/)
  const { default: assistantRoutes } = await import('../routes/assistant.mjs')
  const routes = assistantRoutes({ getProject: () => p, getVersion: () => 1, broadcast() {} }).routes
  assert.throws(() => routes['POST /api/ui/show']({ comp: 'constructor' }), /No composition constructor/)
  assert.throws(() => routes['GET /api/describe'](null, new URLSearchParams('comp=toString')), /no composition toString/)
})
