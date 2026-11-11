import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { audioPlan } from '../core/audio-plan.js'
import * as coreFx from '../core/audio-fx.js'
import * as webFx from '../web/engine/audio-worklets/fx.js'
import { dynamicsLatency } from '../web/engine/audio-worklets/dsp.js'
import { newProject } from '../core/project.js'

registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('/core/') ? new URL(`../core/${specifier.slice(6)}`, import.meta.url).href : specifier, context) } })
const { planAudio, planLeaves, itemSource } = await import('../web/engine/audio.js')

test('browser compatibility exports share the catalog, defaults and limiter latency', () => {
  assert.deepEqual(Object.keys(webFx), Object.keys(coreFx))
  for (const type of Object.keys(coreFx.FX_TYPES)) {
    assert.equal(webFx.FX_TYPES[type], coreFx.FX_TYPES[type])
    assert.deepEqual(webFx.newFx(type), coreFx.newFx(type))
    const fx = coreFx.newFx(type)
    assert.equal(coreFx.fxLatency(fx, 48000), dynamicsLatency(type, 48000, coreFx.fxParams(fx)) / 48000)
  }
})

test('native plan preserves recursive source mapping, mute and master', () => {
  const p = newProject('Mix')
  p.assets = { 'a.wav': { duration: 30, hasAudio: true }, 'b.wav': { duration: 30, hasAudio: true } }
  p.master = { volume: -3, limiter: { enabled: true, ceiling: -2 }, fx: [coreFx.newFx('compressor')] }
  p.comps = { k1: { tracks: [{ id: 'A3', kind: 'audio', volume: -6, clips: [{ id: 'inner', kind: 'audio', src: 'a.wav', in: 4, start: 1, dur: 5, speed: 0.5, fadeIn: 1, volume: -2, fx: [coreFx.newFx('gain', { gain: 3 })] }] }] } }
  p.tracks[0].clips.push({ id: 'comp', kind: 'comp', comp: 'k1', start: 2, in: 1, speed: 2, dur: 3 })
  p.tracks.find(t => t.id === 'A1').clips.push({ id: 'multi', kind: 'multicam', start: 0, dur: 2, in: 0, audioAngle: 1, angles: [{ src: 'a.wav' }, { src: 'b.wav', offset: -0.25 }] })
  const browser = planLeaves(planAudio(p, 0, 8))
  const native = audioPlan(p, 0, 8)
  const leaves = buses => buses.flatMap(b => b.items.flatMap(i => i.kind === 'comp' ? leaves(i.buses) : [i]))
  for (const leaf of leaves(native.buses)) {
    const original = browser.find(i => i.clip.id === leaf.id)
    assert.ok(original)
    assert.equal(leaf.src, original.src)
    assert.equal(leaf.from, original.from)
    assert.equal(leaf.to, original.to)
    assert.equal(leaf.sourceIn, itemSource(original, original.from))
    assert.equal(leaf.speed, original.speed / original.B)
  }
  assert.equal(native.master.gain, 10 ** (-3 / 20))
  assert.equal(native.master.limiter.params.ceiling, -2)
  assert.equal(native.master.chain[0].type, 'compressor')
})

test('native plan reads a reversed clip backwards from the source second the browser plays', () => {
  const p = newProject('Reverse')
  p.assets = { 'a.wav': { duration: 30, hasAudio: true } }
  p.tracks.find(t => t.id === 'A1').clips.push({ id: 'rev', kind: 'audio', src: 'a.wav', in: 2, start: 1, dur: 4, speed: 1.5, reverse: true })
  for (const from of [0, 2.5]) {
    const browser = planLeaves(planAudio(p, from, 8)).find(i => i.clip.id === 'rev')
    const leaf = audioPlan(p, from, 8).buses.flatMap(b => b.items).find(i => i.id === 'rev')
    assert.equal(leaf.reverse, true)
    assert.equal(leaf.from, browser.from)
    assert.equal(leaf.to, browser.to)
    assert.equal(leaf.speed, browser.speed / browser.B)
    // The browser's reversed clip plays source second in + (dur - local) * speed.
    const local = t => (t - browser.A) / browser.B - browser.clip.start
    const source = t => browser.srcIn + (browser.clip.dur - local(t)) * browser.speed
    assert.ok(Math.abs(leaf.sourceIn - source(leaf.from)) < 1e-12)
    assert.ok(Math.abs(leaf.sourceIn - leaf.speed * (leaf.to - leaf.from) - source(leaf.to)) < 1e-12)
  }
  // A negative angle offset ends a reversed leaf where its source reaches second zero.
  p.tracks.find(t => t.id === 'A1').clips.push({ id: 'multi', kind: 'multicam', start: 10, dur: 2, in: 0, reverse: true, audioAngle: 0, angles: [{ src: 'a.wav', offset: -0.5 }] })
  const multi = audioPlan(p, 0, 14).buses.flatMap(b => b.items).find(i => i.id === 'multi')
  assert.equal(multi.reverse, true)
  assert.ok(Math.abs(multi.sourceIn - 1.5) < 1e-12)
  assert.ok(Math.abs(multi.to - 11.5) < 1e-12)
  assert.ok(Math.abs(multi.sourceIn - multi.speed * (multi.to - multi.from)) < 1e-12)
  const forward = audioPlan({ ...p, tracks: p.tracks.map(t => ({ ...t, clips: t.clips.map(c => ({ ...c, reverse: false })) })) }, 0, 8)
  assert.equal(forward.buses.flatMap(b => b.items).find(i => i.id === 'rev').reverse, undefined)
})
