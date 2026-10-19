// node --test editor/test
// The audio engine's planning math: which clips sound when, through nested compositions and
// multicam angles, in what chain order, and with what latency.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The engine imports the shared core by its URL path (/core/project.js), as the browser serves it.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('/core/')) return next(new URL(`../core/${specifier.slice(6)}`, import.meta.url).href, context)

    return next(specifier, context)
  },
})

const { applyOps, newProject } = await import('../core/project.js')
const { clipSteps, itemLocal, leafTiming, masterSteps, planAudio, planLatency, planLeaves, sounds, trackSteps } = await import('../web/engine/audio.js')
const { newFx } = await import('../web/engine/audio-worklets/fx.js')

const near = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`)

function base() {
  const p = newProject('t')
  p.assets = {
    'v.mp4': { duration: 20, hasVideo: true, hasAudio: true },
    'silent.mp4': { duration: 20, hasVideo: true, hasAudio: false },
    'a.wav': { duration: 30, hasVideo: false, hasAudio: true },
    'b.wav': { duration: 30, hasVideo: false, hasAudio: true },
  }

  return p
}

const audioTrack = (p, id) => p.tracks.find(t => t.id === id)

test('main timeline: clips inside the window, track mute and solo', () => {
  const p = base()
  audioTrack(p, 'A1').clips.push({ id: 'c1', kind: 'audio', src: 'a.wav', start: 1, dur: 4, in: 2 })
  audioTrack(p, 'A2').clips.push({ id: 'c2', kind: 'audio', src: 'b.wav', start: 6, dur: 2, in: 0 })
  audioTrack(p, 'A2').clips.push({ id: 'c3', kind: 'audio', src: 'b.wav', start: 9, dur: 2, enabled: false })
  let plan = planAudio(p, 2, 7)
  assert.deepEqual(planLeaves(plan).map(l => [l.clip.id, l.from, l.to]), [['c1', 2, 5], ['c2', 6, 7]])
  audioTrack(p, 'A1').muted = true
  assert.deepEqual(planLeaves(planAudio(p, 0)).map(l => l.clip.id), ['c2'])
  audioTrack(p, 'A1').muted = false
  audioTrack(p, 'A1').solo = true
  assert.deepEqual(planLeaves(planAudio(p, 0)).map(l => l.clip.id), ['c1'])
})

test('leaf timing: buffer offset, rate and a late start', () => {
  const p = base()
  audioTrack(p, 'A1').clips.push({ id: 'c1', kind: 'audio', src: 'a.wav', start: 1, dur: 4, in: 2, speed: 2 })
  const [leaf] = planLeaves(planAudio(p, 2))
  const tm = leafTiming(leaf, { t0: 2, when: 10, rate: 1 })
  assert.equal(tm.at, 10)
  near(tm.offset, 2 + (2 - 1) * 2)
  assert.equal(tm.playbackRate, 2)
  near(tm.dur, 3 * 2)
  // Latency starts it early; a start in the past moves to now and skips ahead in the buffer.
  const early = leafTiming(leaf, { t0: 2, when: 10, latency: 0.25, bufferFrom: 1 })
  near(early.at, 9.75)
  near(early.offset, 3)
  const late = leafTiming(leaf, { t0: 2, when: 10, now: 10.5 })
  near(late.at, 10.5)
  near(late.offset, 4 + 0.5 * 2)
  near(late.dur, 6 - 1)
})

test('comp clips play their composition audio through in and speed, recursively', () => {
  let p = base()
  p = applyOps(p, [{ op: 'add_comp', name: 'Inner' }]).project
  const inner = Object.keys(p.comps)[0]
  p = applyOps(p, [{ op: 'add_comp', name: 'Outer' }]).project
  const outer = Object.keys(p.comps).find(k => k !== inner)
  const audioOf = id => p.comps[id].tracks.find(t => t.kind === 'audio')
  assert.ok(audioOf(inner) && audioOf(outer), 'compositions get an audio track')
  // Inner: a clip at comp time 1–3 reading a.wav from 0.5.
  audioOf(inner).clips.push({ id: 'i1', kind: 'audio', src: 'a.wav', start: 1, dur: 2, in: 0.5 })
  // Outer: the inner comp placed at 2, from inner time 0.5, at double speed.
  p.comps[outer].tracks.find(t => t.kind === 'video').clips.push({ id: 'o1', kind: 'comp', comp: inner, start: 2, dur: 3, in: 0.5, speed: 2 })
  // Main: the outer comp at 10, from outer time 1, normal speed.
  p.tracks.find(t => t.kind === 'video').clips.push({ id: 'm1', kind: 'comp', comp: outer, start: 10, dur: 6, in: 1 })
  assert.equal(sounds(p, p.tracks[0].clips[0]), true)
  const plan = planAudio(p, 0)
  const [leaf] = planLeaves(plan)
  assert.equal(leaf.clip.id, 'i1')
  // Main T ↔ outer time τo = 1 + (T - 10); outer τo ↔ inner τi = 0.5 + (τo - 2) * 2.
  // i1 plays inner 1–3 → outer 2.25–3.25 → main 11.25–12.25.
  near(leaf.from, 11.25)
  near(leaf.to, 12.25)
  near(itemLocal(leaf, 11.75), 1)
  const tm = leafTiming(leaf, { t0: 11, when: 0 })
  near(tm.at, 0.25)
  near(tm.offset, 0.5)
  near(tm.playbackRate, 2)
  near(tm.dur, 2)
  // The tree keeps each comp clip's own chain: main bus → m1 → outer bus → o1 → inner bus → i1.
  const m1 = plan.buses[0].items[0]
  assert.equal(m1.kind, 'comp')
  assert.equal(m1.buses[0].items[0].clip.id, 'o1')
  // The window cuts nested audio too.
  assert.deepEqual(planLeaves(planAudio(p, 11.5, 12)).map(l => [l.from, l.to]), [[11.5, 12]])
})

test('comp audio honors the comp clip mute, track mute and solo inside the composition', () => {
  let p = base()
  p = applyOps(p, [{ op: 'add_comp', name: 'K' }]).project
  const k = Object.keys(p.comps)[0]
  const tracks = p.comps[k].tracks
  const a = tracks.find(t => t.kind === 'audio')
  a.clips.push({ id: 'k1', kind: 'audio', src: 'a.wav', start: 0, dur: 2 })
  tracks.push({ id: 'A9', kind: 'audio', name: 'x', clips: [{ id: 'k2', kind: 'audio', src: 'b.wav', start: 0, dur: 2 }] })
  // Video with embedded sound inside a composition sounds, as on the main timeline.
  tracks.find(t => t.kind === 'video').clips.push({ id: 'k3', kind: 'video', src: 'v.mp4', start: 0, dur: 2 })
  const clip = { id: 'm1', kind: 'comp', comp: k, start: 0, dur: 2 }
  p.tracks[0].clips.push(clip)
  const ids = () => planLeaves(planAudio(p, 0)).map(l => l.clip.id).sort()
  assert.deepEqual(ids(), ['k1', 'k2', 'k3'])
  a.solo = true
  assert.deepEqual(ids(), ['k1', 'k3'])
  a.solo = false
  a.muted = true
  assert.deepEqual(ids(), ['k2', 'k3'])
  clip.mute = true
  assert.deepEqual(ids(), [])
})

test('multicam clips play the audio angle at its offset; a negative offset starts late', () => {
  const p = base()
  p.tracks[0].clips.push({
    id: 'mc', kind: 'multicam', start: 2, dur: 6, in: 1,
    angles: [{ src: 'v.mp4', offset: 0.5 }, { src: 'silent.mp4', offset: 0 }, { src: 'a.wav', offset: -3 }],
    cuts: [{ t: 0, angle: 1 }], audioAngle: 0,
  })
  let [leaf] = planLeaves(planAudio(p, 0))
  assert.equal(leaf.src, 'v.mp4')
  near(leaf.from, 2)
  near(leafTiming(leaf, { t0: 0, when: 0 }).offset, 1.5)
  // The audio angle, not the picture angle, decides: angle 1 has no sound.
  p.tracks[0].clips[0].audioAngle = 1
  assert.deepEqual(planLeaves(planAudio(p, 0)), [])
  // Angle 2 at offset -3: multicam time 1 reads source -2, so sound starts 2 s into the clip.
  p.tracks[0].clips[0].audioAngle = 2
  ;[leaf] = planLeaves(planAudio(p, 0))
  near(leaf.from, 4)
  near(leafTiming(leaf, { t0: 0, when: 0 }).offset, 0)
  near(leafTiming(leaf, { t0: 0, when: 0 }).at, 4)
})

test('chain order: legacy eq, enabled effects in order, then volume and pan; master limiter last', () => {
  const c = { eq: { low: 3 }, fx: [newFx('compressor'), { ...newFx('gate'), enabled: false }, { type: 'unknown' }, newFx('reverb')] }
  assert.deepEqual(clipSteps(c).map(s => s.kind + (s.fx ? `:${s.fx.type}` : '')), ['eq', 'fx:compressor', 'fx:reverb', 'volume', 'pan'])
  assert.deepEqual(clipSteps({}).map(s => s.kind), ['volume', 'pan'])
  assert.deepEqual(trackSteps({ fx: [newFx('deesser')], volume: -3, pan: 0.5 }).map(s => [s.kind, s.fx?.type ?? s.db ?? s.value]), [['fx', 'deesser'], ['volume', -3], ['pan', 0.5]])
  const master = { fx: [newFx('eq'), newFx('compressor')], volume: 2, limiter: newFx('limiter') }
  assert.deepEqual(masterSteps(master).map(s => s.fx?.type ?? s.kind), ['eq', 'compressor', 'volume', 'limiter'])
})

test('latency: limiters on the path add up, the master part is reported apart', () => {
  const p = base()
  audioTrack(p, 'A1').fx = [newFx('limiter', { lookahead: 5 })]
  audioTrack(p, 'A1').clips.push({ id: 'c1', kind: 'audio', src: 'a.wav', start: 0, dur: 2, fx: [newFx('limiter', { lookahead: 2 })] })
  audioTrack(p, 'A2').clips.push({ id: 'c2', kind: 'audio', src: 'b.wav', start: 0, dur: 2 })
  p.master = { limiter: { enabled: true, lookahead: 5 } }
  const lat = planLatency(planAudio(p, 0), 48000)
  near(lat.master, 255 / 48000)
  near(lat.max, (255 + 255 + 111) / 48000)
  assert.equal(planLatency(planAudio(base(), 0), 48000).max, 0)
})

test('a muted audio clip is silent in preview and export plans', () => {
  let p = newProject('t')
  p.assets = { 'a.wav': { duration: 30, hasVideo: false, hasAudio: true } }
  p = applyOps(p, [{ op: 'add_clip', src: 'a.wav', track: 'A1', start: 0, dur: 4 }, { op: 'add_clip', src: 'a.wav', track: 'A2', start: 0, dur: 4 }]).project
  const muted = p.tracks.find(t => t.id === 'A1').clips[0]
  const playing = p.tracks.find(t => t.id === 'A2').clips[0]
  p = applyOps(p, [{ op: 'update', id: muted.id, set: { mute: true } }]).project
  assert.equal(sounds(p, p.tracks.find(t => t.id === 'A1').clips[0]), false)
  assert.deepEqual(planLeaves(planAudio(p, 0)).map(leaf => leaf.clip.id), [playing.id])
})
